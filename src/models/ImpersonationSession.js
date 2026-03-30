module.exports = (sequelize, DataTypes) => {
  const ImpersonationSession = sequelize.define(
    'ImpersonationSession',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      super_admin_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      target_org_id: DataTypes.UUID,
      target_emp_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      started_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
      ended_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'impersonation_sessions',
      paranoid: true,
      underscored: true,
    }
  );

  ImpersonationSession.associate = (models) => {
    ImpersonationSession.belongsTo(models.Employee, { foreignKey: 'super_admin_id', as: 'superAdmin' });
    ImpersonationSession.belongsTo(models.Employee, { foreignKey: 'target_emp_id', as: 'targetEmployee' });
  };

  return ImpersonationSession;
};
