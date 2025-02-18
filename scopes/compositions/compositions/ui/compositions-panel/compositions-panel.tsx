import { Icon } from '@teambit/evangelist.elements.icon';
import classNames from 'classnames';
import React, { useCallback } from 'react';
import { MenuWidgetIcon } from '@teambit/ui-foundation.ui.menu-widget-icon';
import { useNavigate, useLocation } from '@teambit/base-react.navigation.link';
import { Composition } from '../../composition';
import styles from './compositions-panel.module.scss';

export type CompositionsPanelProps = {
  /**
   * list of compositions
   */
  compositions: Composition[];
  /**
   * select composition to display
   */
  onSelectComposition: (composition: Composition) => void;
  /**
   * the currently active composition
   */
  active?: Composition;
  /**
   * the url to the base composition. doesntc contain the current composition params
   */
  url: string;
  /**
   * checks if a component is using the new preview api. if false, doesnt scale to support new preview
   */
  isScaling?: boolean;

  includesEnvTemplate?: boolean;
} & React.HTMLAttributes<HTMLUListElement>;

export function CompositionsPanel({
  url,
  compositions,
  isScaling,
  onSelectComposition: onSelect,
  active,
  includesEnvTemplate,
  className,
  ...rest
}: CompositionsPanelProps) {
  const shouldAddNameParam = isScaling && includesEnvTemplate === false;

  const handleSelect = useCallback(
    (selected: Composition) => {
      onSelect && onSelect(selected);
    },
    [onSelect]
  );

  const location = useLocation();
  const navigate = useNavigate();

  const onCompositionCodeClicked = useCallback(
    (composition: Composition) => (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const basePath = location?.pathname.split('/~compositions')[0];
      navigate(`${basePath}/~code/${composition.filepath}#search=${composition.identifier}`);
    },
    [location?.pathname]
  );

  return (
    <ul {...rest} className={classNames(className)}>
      {compositions.map((composition) => {
        const href = shouldAddNameParam ? `${url}&name=${composition.identifier}` : `${url}&${composition.identifier}`;
        return (
          <li
            key={composition.identifier}
            className={classNames(styles.linkWrapper, composition === active && styles.active)}
          >
            <a className={styles.panelLink} onClick={() => handleSelect(composition)}>
              <span className={styles.box}></span>
              <span className={styles.name}>{composition.displayName}</span>
            </a>
            <div className={styles.right}>
              <MenuWidgetIcon
                className={styles.codeLink}
                icon="Code"
                tooltipContent="Code"
                onClick={onCompositionCodeClicked(composition)}
              />
              <a className={styles.panelLink} target="_blank" rel="noopener noreferrer" href={href}>
                <Icon className={styles.icon} of="open-tab" />
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
